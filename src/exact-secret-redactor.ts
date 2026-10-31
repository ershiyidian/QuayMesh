/** Filter one explicitly issued credential before process output is buffered or
 * persisted. Only a possible secret prefix is held between chunks; unrelated
 * output streams immediately and a partial non-match is released at EOF. */
export class ExactSecretRedactor {
  private pending = "";
  constructor(private readonly secret: string | undefined) {}

  push(chunk: string): string {
    if (!this.secret) return chunk;
    const text = (this.pending + chunk).replaceAll(this.secret, "[redacted]");
    this.pending = "";
    for (let length = Math.min(this.secret.length - 1, text.length); length > 0; length--) {
      if (this.secret.startsWith(text.slice(-length))) {
        this.pending = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    return text;
  }

  flush(): string {
    const text = this.pending;
    this.pending = "";
    return text;
  }
}
