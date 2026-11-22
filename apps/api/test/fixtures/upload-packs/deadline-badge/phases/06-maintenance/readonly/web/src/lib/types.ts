/** A task on the team's list. Dates are ISO strings: yyyy-mm-dd. */
export interface Task {
  readonly title: string;
  readonly dueDate: string | null;
  readonly done: boolean;
}
