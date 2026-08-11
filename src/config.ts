// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
export interface MedplumAppConfig {
  baseUrl?: string;
}

const config: MedplumAppConfig = {
  baseUrl: import.meta.env?.MEDPLUM_BASE_URL,
};

export function getConfig(): MedplumAppConfig {
  return config;
}
