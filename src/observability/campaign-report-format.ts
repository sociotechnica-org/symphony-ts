export function renderCampaignIssueLabel(
  issueNumber: number,
  title: string | null,
): string {
  return title === null
    ? `#${issueNumber.toString()}`
    : `#${issueNumber.toString()} ${title}`;
}

export function renderCampaignNameList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
