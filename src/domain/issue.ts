export interface QueuePriority {
  /**
   * Lower ranks are higher priority. Trackers normalize native priority
   * semantics into this ascending integer scale at the boundary.
   */
  readonly rank: number;
  readonly label: string | null;
}

export interface RuntimeIssueBlocker {
  readonly id: string | null;
  readonly identifier: string | null;
  readonly title: string | null;
  readonly state: string | null;
}

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
  readonly closedAt?: string | null;
  readonly queuePriority: QueuePriority | null;
  readonly blockedBy: readonly RuntimeIssueBlocker[];
}
