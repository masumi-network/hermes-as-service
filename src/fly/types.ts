// Fly Machines REST API types — only the fields we use, not the full schema.

export interface FlyApp {
  id?: string;
  name: string;
  organization_slug?: string;
  status?: string;
}

export interface FlyMachineConfig {
  image: string;
  env?: Record<string, string>;
  guest?: {
    cpu_kind: 'shared' | 'performance';
    cpus: number;
    memory_mb: number;
  };
  mounts?: { volume: string; path: string }[];
  services?: {
    ports: { port: number; handlers?: string[] }[];
    protocol: 'tcp' | 'udp';
    internal_port: number;
    auto_stop_machines?: 'off' | 'stop' | 'suspend';
    auto_start_machines?: boolean;
    min_machines_running?: number;
  }[];
  restart?: { policy: 'no' | 'always' | 'on-failure' };
}

export interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  region: string;
  config: FlyMachineConfig;
  image_ref?: { registry?: string; repository?: string; tag?: string };
  private_ip?: string;
  instance_id?: string;
  created_at?: string;
}

export interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
  attached_machine_id?: string | null;
}

export interface CreateMachineRequest {
  name?: string;
  region: string;
  config: FlyMachineConfig;
}

export interface CreateVolumeRequest {
  name: string;
  region: string;
  size_gb: number;
  encrypted?: boolean;
}
