/** A return to the same user after logout is a new session. Token refreshes
 * of an uninterrupted user keep their controllers and private drafts. */
export class AuthIncarnation {
  private state = { userId: null as string | null, epoch: 0 };
  snapshot = () => this.state;
  observe(userId: string | null) {
    if (this.state.userId === userId) return false;
    this.state = { userId, epoch: this.state.epoch + 1 }; return true;
  }
  current(userId: string | null, epoch: number) { return userId !== null && this.state.userId === userId && this.state.epoch === epoch; }
}
