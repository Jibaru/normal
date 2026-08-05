class TestClerk {
  constructor() {
    this.loaded = false;
    this.listeners = new Set();
    this.telemetry = { record() {} };
    this.syncFromConfig();
  }

  syncFromConfig() {
    const config = window.__clerkTestConfig ?? {};
    this.session = config.session ?? null;
    this.user = this.session ? { id: "user_playwright" } : null;
    this.client = { activeSessions: this.session ? [this.session] : [] };
    this.organization = null;
    this.__internal_lastEmittedResources = {
      client: this.client,
      organization: this.organization,
      session: this.session,
      user: this.user,
    };
  }

  async load() {
    this.syncFromConfig();
    this.loaded = true;
    this.emit();
  }

  addListener(listener, options) {
    this.listeners.add(listener);
    if (!options?.skipInitialEmit) queueMicrotask(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    this.syncFromConfig();
    for (const listener of this.listeners) listener();
  }

  get isSignedIn() {
    return this.session !== null;
  }

  openSignIn() {
    window.__clerkTestConfig?.openSignIn?.();
    this.emit();
  }

  openWaitlist() {
    window.__clerkTestConfig?.openWaitlist?.();
  }

  __internal_openReverification(options) {
    window.__clerkTestConfig?.openReverification?.();
    options?.afterVerification?.();
  }
}

window.Clerk = new TestClerk();
