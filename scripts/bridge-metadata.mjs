// Packaging replaces this constant in the running bundle. Development source
// deliberately reports no version rather than inferring it from mutable files.
export function bridgeMetadata() {
  return {
    schemaVersion: 1,
    bridgeVersion: typeof __SAC_BRIDGE_VERSION__ === 'undefined' ? null : __SAC_BRIDGE_VERSION__,
    capabilities: ['hermes-connection-inspection-v1', 'ekko-authorization-record-v1', 'hermes-shared-session-v1', 'hermes-history-snapshot-v1'],
  };
}
