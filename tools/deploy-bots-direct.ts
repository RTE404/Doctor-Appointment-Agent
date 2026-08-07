// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient, getReferenceString, OperationOutcomeError } from '@medplum/core';
import type { WithId } from '@medplum/core';
import type { Bot } from '@medplum/fhirtypes';
import { readFileSync } from 'fs';
import 'dotenv/config';

async function main(): Promise<void> {
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (!process.env.MEDPLUM_BASE_URL || !clientId || !clientSecret) {
    throw new Error('MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, and MEDPLUM_CLIENT_SECRET must all be set (see .env)');
  }
  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
  await medplum.startClientLogin(clientId, clientSecret);

  const bundle = JSON.parse(readFileSync('data/core/example-bots.json', 'utf-8'));
  const botEntries = bundle.entry.filter((e: any) => e.resource?.resourceType === 'Bot');

  // Get the current project id for the admin bot-creation endpoint — a bare
  // createResource({resourceType:'Bot',...}) skips the ProjectMembership
  // the admin endpoint creates, which a Bot needs to actually run as an
  // authenticated actor (confirmed against botinit.ts).
  const activeLogin = medplum.getActiveLogin();
  const projectId = activeLogin?.project?.reference?.split('/')[1];
  if (!projectId) {
    throw new Error('Could not determine the active project id from the current login');
  }

  let bundleString = JSON.stringify(bundle);
  const botIds: Record<string, string> = {};
  for (const entry of botEntries) {
    const botName = entry.resource.name;
    let bot = await medplum.searchOne('Bot', { name: botName });
    if (!bot) {
      try {
        bot = (await medplum.post('admin/projects/' + projectId + '/bot', { name: botName })) as WithId<Bot>;
      } catch (err) {
        // LIVE-DEPLOY FINDING (Task 26, not in the brief): the admin bot-creation endpoint
        // (`admin/projects/{id}/bot`) is gated by `verifyProjectAdmin`, which requires
        // `ctx.membership.admin === true` (confirmed by reading
        // medplum/packages/server/src/admin/utils.ts and project.ts directly). The
        // MEDPLUM_CLIENT_ID/SECRET client ("seed-cli") in this repo's .env is NOT a project
        // admin in the live target project — `medplum.get('auth/me')` shows its
        // ProjectMembership has no `admin` flag — so this call fails with 403 Forbidden.
        //
        // Falling back to a bare createResource(Bot) here, same as the brief's own point #3
        // documents as "incomplete": it skips the ProjectMembership that lets the Bot run as
        // its own scoped actor. Confirmed the concrete effect by reading
        // medplum/packages/server/src/bots/utils.ts (getBotProjectMembership) and
        // fhir/operations/deploy.ts directly:
        //   - $deploy will still succeed, but returns an operational warning
        //     ("Could not find ProjectMembership for Bot").
        //   - At execution time the bot has no ProjectMembership of its own, so
        //     getBotProjectMembership falls back to the CALLER's membership — the bot runs
        //     with whichever client/user invoked executeBot, not a consistent scoped
        //     identity/access-policy/secret-scope of its own.
        // This is a real gap, not a cosmetic one: it should be fixed by granting `admin: true`
        // on seed-cli's ProjectMembership (or creating bots through a true project-admin
        // credential) so the admin endpoint's ProjectMembership-per-bot step actually runs.
        if (err instanceof OperationOutcomeError && err.outcome.id === 'forbidden') {
          console.warn(
            `WARNING: admin bot-creation endpoint forbidden for bot "${botName}" ` +
              '(seed-cli is not a project admin). Falling back to a bare Bot creation without ' +
              'its own ProjectMembership — see comment above for the operational implications.'
          );
          bot = (await medplum.createResource({
            resourceType: 'Bot',
            name: botName,
            runtimeVersion: 'awslambda',
          })) as WithId<Bot>;
        } else {
          throw err;
        }
      }
    }
    botIds[botName] = bot.id;
    // No backslashes needed — this is a real .ts file, not a shell-quoted string, so `$`
    // is a plain character here with no escaping semantics to fight.
    bundleString = bundleString
      .replaceAll('$bot-' + botName + '-reference', getReferenceString(bot))
      .replaceAll('$bot-' + botName + '-id', bot.id);
  }

  await medplum.executeBatch(JSON.parse(bundleString));

  // Match each bot's OWN executableCode.url to its own Binary entry by
  // fullUrl — the earlier version of this script grabbed 'the first
  // JavaScript Binary' once, outside this loop, so every bot got the same
  // code. This is exactly the pattern UploadDataPage.tsx's real upload
  // handler uses (confirmed by reading it directly).
  // try/catch per bot (not in the brief's sample, which lets the first $deploy failure throw
  // and abort the whole loop) so a single bot's failure doesn't hide the outcome for the other
  // six — needed here because this run surfaced a real, project-wide "Bots not enabled" error
  // (see report) that affects every bot identically, and we want a complete picture, not just
  // the first failure.
  let deployFailures = 0;
  for (const entry of botEntries) {
    const botName = entry.resource.name;
    const distUrl = entry.resource.executableCode?.url;
    const distBinaryEntry = bundle.entry.find((e: any) => e.fullUrl === distUrl);
    if (!distBinaryEntry?.resource?.data) {
      throw new Error('Could not find compiled code Binary for bot: ' + botName);
    }
    const code = Buffer.from(distBinaryEntry.resource.data, 'base64').toString('utf-8');
    try {
      await medplum.post(medplum.fhirUrl('Bot', botIds[botName], '$deploy'), { code });
      console.log('Deployed', botName);
    } catch (err) {
      deployFailures++;
      const outcome = err instanceof OperationOutcomeError ? err.outcome : err;
      console.error('FAILED to deploy', botName, JSON.stringify(outcome));
    }
  }
  if (deployFailures > 0) {
    throw new Error(`${deployFailures} of ${botEntries.length} bot(s) failed to deploy — see errors above`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
