export type AdminAddressIssue =
  | 'socket_unavailable'
  | 'untrusted_proxy'
  | 'missing_address'
  | 'duplicate_header'
  | 'invalid_address'
  | 'conflicting_addresses';

export type AdminNetworkDiagnostic = {
  connection: string | null;
  client: string | null;
  issue?: AdminAddressIssue;
};
