export interface TodylEnvelope<T> {
  data: T[];
  meta: { has_more: boolean; next_cursor?: string };
}

export interface TenantRef {
  id: string;
  name: string;
}

export interface Device {
  id: string;
  udid?: string;
  serial_number?: string;
  name?: string;
  billing_status?: string;
  pause_expires_at?: string;
  reboot_required_at?: string;
  device_type?: string;
  operating_system?: {
    type?: string;
    version?: string;
    agent_version?: string;
    latest_available_agent_version?: string;
  };
  deployment_group?: { id: string; name: string };
  tenant?: TenantRef;
  session?: {
    account_name?: string;
    is_mfa?: boolean;
    connected_at?: string;
    disconnected_at?: string;
    pop_location?: string;
  };
  tamper_protection?: { enabled?: boolean };
  last_checkin_at?: string;
  created_at?: string;
  updated_at?: string;
}

/** Deploy-key credentials are stripped in parse.ts and are absent by design. */
export interface DeploymentGroup {
  id: string;
  name?: string;
  note?: string;
  bundle?: { id: string; name: string };
  tenant?: TenantRef;
  products?: { id: string; type?: string; display_name?: string; is_tenant_wide?: boolean }[];
  device_count?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Invoice {
  id: string;
  guid?: string;
  status?: string;
  period_started_at?: string;
  period_ended_at?: string;
  subtotal?: number;
  currency?: string;
  tenant?: TenantRef;
  subtenants?: TenantRef[];
}
