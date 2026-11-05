export type BridgeSettings = { bridgeUrl: string; bridgeToken: string };

export function connectionStatus(input: { hasToken: boolean; syncOk: boolean; error?: unknown }): string {
  if (!input.hasToken) return 'AI 尚未配置，可稍后连接';
  if (input.syncOk) return 'Hermes · 已连接';
  return `Hermes · 未连接：${connectionFailureMessage(input.error)}`;
}

export function mergeSettings(current: BridgeSettings, patch: Partial<BridgeSettings>): BridgeSettings {
  return {
    bridgeUrl: typeof patch.bridgeUrl === 'string' && patch.bridgeUrl.trim() ? patch.bridgeUrl.trim() : current.bridgeUrl,
    bridgeToken: current.bridgeToken,
  };
}

export function connectionFailureMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'install_mismatch' || code === 'install_changed') return 'Hermes 安装身份已变化，请核对连接';
  if (code === 'auth_failed') return 'Hermes 认证失败，请核对凭证';
  if (code === 'source_unknown') return 'Chat 来源待确认，请先核对并关联';
  const message = error instanceof Error ? error.message : String(error ?? '连接失败');
  if (!message.trim() || /token|api[-_ ]?key|authorization|bearer|secret/i.test(message)) return '连接失败';
  return message.slice(0, 120);
}
