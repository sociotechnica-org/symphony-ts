export const RATE_LIMIT_PATTERNS = [
  /\brate limit\b/iu,
  /\btoo many requests\b/iu,
  /\bthrottl(?:e|ed|ing)\b/iu,
] as const;

export const RATE_LIMIT_FALLBACK_PATTERNS = [
  /\brate limit\b/iu,
  /\btoo many requests\b/iu,
  /\brequests? (?:were |was )?throttl(?:ed|ing)\b/iu,
] as const;

export const ACCOUNT_PRESSURE_PATTERNS = [
  /\binsufficient quota\b/iu,
  /\bquota exceeded\b/iu,
  /\bbilling (?:hard )?limit(?: reached| exceeded)?\b/iu,
  /\bbilling (?:error|disabled|required)\b/iu,
  /\bpayment required\b/iu,
  /\bcredit balance\b/iu,
  /\bcredits? (?:exceeded|exhausted|depleted|insufficient|remaining|limit)\b/iu,
  /\b(?:no|insufficient|low) credits?\b/iu,
  /\bsubscription (?:expired|required|inactive)\b/iu,
  /\bapi (?:key|token) (?:expired|revoked|invalid)\b/iu,
  /\baccount (?:limit|restricted|disabled)\b/iu,
] as const;

export const ACCOUNT_PRESSURE_FALLBACK_PATTERNS = [
  /\binsufficient quota\b/iu,
  /\bquota exceeded\b/iu,
  /\bbilling (?:hard )?limit(?: reached| exceeded)?\b/iu,
  /\bbilling (?:error|disabled|required)\b/iu,
  /\bpayment required\b/iu,
  /\bcredits? (?:exceeded|exhausted|depleted|limit)\b/iu,
  /\bno credits?\b/iu,
  /\baccount (?:limit|restricted|disabled)\b/iu,
] as const;
