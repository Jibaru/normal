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
    if (window.__clerkTestConfig?.renderReverification) {
      const backdrop = document.createElement("div");
      backdrop.dataset.testid = "clerk-reverification-layer";
      Object.assign(backdrop.style, {
        alignItems: "center",
        background: "rgba(0, 0, 0, 0.4)",
        display: "flex",
        inset: "0",
        justifyContent: "center",
        position: "fixed",
        zIndex: "10000",
      });

      const dialog = document.createElement("div");
      dialog.setAttribute("aria-label", "Verify your identity");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("role", "dialog");
      Object.assign(dialog.style, {
        background: "white",
        borderRadius: "12px",
        color: "black",
        padding: "24px",
      });

      const title = document.createElement("p");
      title.textContent = "Verify your identity";
      const complete = document.createElement("button");
      complete.textContent = "Complete verification";
      complete.addEventListener("click", () => {
        backdrop.remove();
        options?.afterVerification?.();
      });
      dialog.append(title, complete);
      backdrop.append(dialog);
      document.body.append(backdrop);
      return;
    }
    options?.afterVerification?.();
  }
}

window.Clerk = new TestClerk();
