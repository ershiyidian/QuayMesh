/** Only numeric TAP footer fields cross the reporting boundary; raw test text never does. */
export class TestReceiptSummary {
  private pending = "";
  private discardUntilNewline = false;
  private values: Record<string, number> = {};

  accept(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      if (this.discardUntilNewline) {
        if (part.endsWith("\n")) this.discardUntilNewline = false;
        continue;
      }
      this.pending += part;
      if (this.pending.length > 65_536) {
        this.discardUntilNewline = !this.pending.endsWith("\n");
        this.pending = "";
      } else if (this.pending.endsWith("\n")) {
        const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9]+(?:\.[0-9]+)?)\r?\n$/.exec(this.pending);
        if (match) this.values[match[1]!] = Number(match[2]);
        this.pending = "";
      }
    }
  }

  result(exitCode: number | null, sourceUnchanged: boolean) {
    const fields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
    const complete = fields.every((field) => Number.isSafeInteger(this.values[field]) && this.values[field]! >= 0)
      && this.values.tests! > 0
      && this.values.tests === this.values.pass! + this.values.fail! + this.values.cancelled! + this.values.skipped! + this.values.todo!;
    const status = !sourceUnchanged ? "source_changed" : !complete ? "incomplete"
      : exitCode === 0 && this.values.fail === 0 && this.values.cancelled === 0 ? "passed" : "failed";
    return { status, exitCode, sourceUnchanged, footerComplete: complete, counts: { ...this.values }, rawLogsShared: false };
  }
}
