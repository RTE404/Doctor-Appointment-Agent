// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/// <reference lib="DOM" />
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import { Notifications } from '@mantine/notifications';
import '@mantine/notifications/styles.css';
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import { MedplumProvider } from '@medplum/react';
import '@medplum/react/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { getConfig } from './config';
import { clearBrowserDemoAccessToken, clearDemoSession, getBrowserDemoAccessToken } from './demoSession';

const demoAccessToken = getBrowserDemoAccessToken();

const medplum = new MedplumClient({
  onUnauthenticated: () => {
    clearBrowserDemoAccessToken();
    window.location.replace('/');
  },
  cacheTime: 5000,
  baseUrl: getConfig().baseUrl,
  accessToken: demoAccessToken,
  storage: new ClientStorage(new MemoryStorage()),
});

medplum.addEventListener('change', () => {
  if (!medplum.getAccessToken()) {
    clearBrowserDemoAccessToken();
  }
});

if (demoAccessToken) {
  medplum.getProfileAsync().then((profile) => {
    if (!profile) {
      clearDemoSession(medplum);
      window.location.replace('/');
    }
  }).catch(() => {
    clearDemoSession(medplum);
    window.location.replace('/');
  });
}

const theme = createTheme({
  headings: {
    sizes: {
      h1: {
        fontSize: '1.125rem',
        fontWeight: '500',
        lineHeight: '2.0',
      },
    },
  },
  fontSizes: {
    xs: '0.6875rem',
    sm: '0.875rem',
    md: '0.875rem',
    lg: '1.0rem',
    xl: '1.125rem',
  },
});

const container = document.getElementById('root') as HTMLDivElement;
const root = createRoot(container);
root.render(
  <StrictMode>
    <BrowserRouter>
      <MedplumProvider medplum={medplum}>
        <MantineProvider theme={theme}>
          <Notifications />
          <App />
        </MantineProvider>
      </MedplumProvider>
    </BrowserRouter>
  </StrictMode>
);
