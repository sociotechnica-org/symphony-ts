export const RATE_LIMIT_PATTERNS = [
  /\brate limit\b/iu,
  /\b429\b/u,
  /\btoo many requests\b/iu,
  /\bthrottl(?:e|ed|ing)\b/iu,
] as const;

export const ACCOUNT_PRESSURE_PATTERNS = [
  /\binsufficient quota\b/iu,
  /\bquota exceeded\b/iu,
  /\bbilling\b/iu,
  /\bpayment required\b/iu,
  /\bcredit(?:s| balance)?\b/iu,
  /\bsubscription (?:expired|required|inactive)\b/iu,
  /\bauthentication required\b/iu,
  /\baccount (?:limit|restricted|disabled|issue)\b/iu,
] as const;
