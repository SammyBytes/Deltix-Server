export class RepoBranchMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(repoId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repoId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      repoId,
      previous.then(() => current),
    );
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(repoId) === current) {
        this.tails.delete(repoId);
      }
    }
  }
}

export const sharedRepoBranchMutex = new RepoBranchMutex();
