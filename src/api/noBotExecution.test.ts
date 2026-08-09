import { readFile } from 'node:fs/promises';

const workflowFiles = [
  '../components/actions/BlockAvailability.tsx',
  '../components/actions/CreateUpdateSlot.tsx',
  '../components/actions/RescheduleAppointment.tsx',
  '../pages/agent/PatientHistoryPage.tsx',
  '../pages/agent/DoctorResultsPage.tsx',
  '../pages/agent/SlotPickerPage.tsx',
  '../pages/desk/PatientAgentChatPage.tsx',
  '../pages/UploadDataPage.tsx',
];

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('active UI workflows do not execute Medplum Bots', async () => {
  const sources = await Promise.all(workflowFiles.map(readSource));

  for (const [index, source] of sources.entries()) {
    expect(source, workflowFiles[index]).not.toContain('.executeBot(');
  }
});

test('example-data upload remains inaccessible from the UI', async () => {
  const [appSource, uploadDataSource] = await Promise.all([readSource('../App.tsx'), readSource('../pages/UploadDataPage.tsx')]);

  expect(appSource).not.toContain("href: '/upload/example'");
  expect(uploadDataSource).not.toContain('example-data');
});

test('legacy Bot upload remains unreachable from the Vercel POC UI', async () => {
  const [appSource, uploadDataSource] = await Promise.all([readSource('../App.tsx'), readSource('../pages/UploadDataPage.tsx')]);

  expect(appSource).not.toContain("href: '/upload/bots'");
  expect(appSource).not.toContain('path="/upload/:dataType"');
  expect(appSource).toContain('path="/upload/core" element={<UploadDataPage uploadType="core" />}');
  expect(uploadDataSource).toContain("case 'bots'");
  expect(uploadDataSource).toContain('uploadExampleBots');
});
