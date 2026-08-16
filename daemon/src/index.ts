import { EVENT_TYPES } from '@cursor-remote/protocol';

export interface DaemonFoundationInfo {
  readonly component: 'daemon';
  readonly protocolEventTypeCount: number;
}

export function getDaemonFoundationInfo(): DaemonFoundationInfo {
  return {
    component: 'daemon',
    protocolEventTypeCount: EVENT_TYPES.length,
  };
}
