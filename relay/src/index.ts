import { COMMAND_TYPES } from '@cursor-remote/protocol';

export interface RelayFoundationInfo {
  readonly component: 'relay';
  readonly protocolCommandTypeCount: number;
}

export function getRelayFoundationInfo(): RelayFoundationInfo {
  return {
    component: 'relay',
    protocolCommandTypeCount: COMMAND_TYPES.length,
  };
}
