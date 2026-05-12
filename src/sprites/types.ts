export type SpriteStatus = 'creating' | 'running' | 'suspended' | 'stopped' | 'error' | string;

export interface Sprite {
  id: string;
  name: string;
  organization?: string;
  url: string;
  url_settings?: {
    auth?: 'public' | 'token' | 'private' | string;
  };
  status: SpriteStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateSpriteRequest {
  name: string;
  region?: string;
  wait_for_capacity?: boolean;
  url_settings?: {
    auth?: 'public' | 'token' | 'private';
  };
}

export interface UpdateSpriteRequest {
  url_settings?: {
    auth?: 'public' | 'token' | 'private';
  };
}

export interface ServiceDefinition {
  cmd: string;
  args?: string[];
  needs?: string[];
  http_port?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface ExecOptions {
  env?: Record<string, string>;
  dir?: string;
  stdin?: string;
  timeoutMs?: number;
}
