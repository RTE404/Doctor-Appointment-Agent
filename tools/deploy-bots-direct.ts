// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient, OperationOutcomeError, getReferenceString } from '@medplum/core';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import 'dotenv/config';
import { getOrCreateDeploymentBot } from './deploy-bot-provisioning';

async function main(): Promise<void> {
  const baseUrl = process.env.MEDPLUM_BASE_URL;
  const clientId = process.env.SEED_MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.SEED_MEDPLUM_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error(
      'MEDPLUM_BASE_URL, SEED_MEDPLUM_CLIENT_ID, and SEED_MEDPLUM_CLIENT_SECRET must all be set (see .env)'
    );
  }

  const medplum = new MedplumClient({ baseUrl });
  await medplum.startClientLogin(clientId, clientSecret);

  const bundle = JSON.parse(readFileSync('data/core/example-bots.json', 'utf-8'));
  const botEntries = bundle.entry.filter((entry: any) => entry.resource?.resourceType === 'Bot');
  const projectId = medplum.getActiveLogin()?.project?.reference?.split('/')[1];
  if (!projectId) {
    throw new Error('Could not determine the active project id from the current login');
  }

  let bundleString = JSON.stringify(bundle);
  const botIds: Record<string, string> = {};
  for (const entry of botEntries) {
    const botName = entry.resource.name;
    const bot = await getOrCreateDeploymentBot(medplum, projectId, botName);
    botIds[botName] = bot.id;
    bundleString = bundleString
      .replaceAll('$bot-' + botName + '-reference', getReferenceString(bot))
      .replaceAll('$bot-' + botName + '-id', bot.id);
  }

  await medplum.executeBatch(JSON.parse(bundleString));

  let deployFailures = 0;
  for (const entry of botEntries) {
    const botName = entry.resource.name;
    const distUrl = entry.resource.executableCode?.url;
    const distBinaryEntry = bundle.entry.find((candidate: any) => candidate.fullUrl === distUrl);
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

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
