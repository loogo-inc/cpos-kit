/** cpos.manifest.json の正準形 (CPOS 本体の manifest 取込の型と同じ)。 */
export interface CposAppManifest {
  appId: string;
  name: string;
  version?: string;
  description?: string;
  type?: 'fullstack' | 'api' | 'worker';
  url?: string;
  icon?: string | null;
  isPublic?: boolean;
  apiTokenScopes?: string[];
  resources?: Array<{ name: string; description?: string }>;
  prompts?: unknown[];
  promptManifestPath?: string;
  scheduledTasks?: Array<{
    taskKey: string;
    schedule: string;
    timezone?: string;
    description?: string;
    endpoint: string;
    method?: 'GET' | 'POST';
  }>;
  webhookEvents?: Array<{ name: string; description: string; payloadType?: string }>;
  requiredPermissions?: Array<{ resource: string; actions: string[] }>;
  [extra: string]: unknown;
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const SCHEMA_PATH: string;
export const schema: Record<string, unknown>;
export function validateManifest(manifest: unknown): ManifestValidation;
export function readManifest(path: string): ManifestValidation & { manifest: CposAppManifest | null };
