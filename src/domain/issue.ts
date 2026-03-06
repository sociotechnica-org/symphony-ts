export interface RuntimeIssue {
  readonly id: string;
  readonly identifier: string;
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
