import { useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient, getMe, type Me, readAccessSecret } from "./api/client.ts";
import { useAppContext } from "./contexts/AppContext.tsx";
import "./App.css";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly me: Me };

const describeError = (error: unknown): string => {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_access_secret":
        return "The access secret in the custom app parameters is wrong. Ask an admin to check the custom app settings.";
      case "not_allowed":
      case "role_not_allowed":
        return error.message;
      default:
        return `The server returned an error: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : "Something went wrong";
};

const App = () => {
  const context = useAppContext();
  const accessSecret = readAccessSecret(context.appConfig);
  const client = useMemo(
    () =>
      accessSecret === null
        ? null
        : createApiClient({ accessSecret, userId: context.userId, userEmail: context.userEmail }),
    [accessSecret, context.userId, context.userEmail],
  );
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (client === null) {
      return;
    }
    let cancelled = false;
    getMe(client).then(
      (me) => !cancelled && setState({ kind: "ready", me }),
      (error: unknown) => !cancelled && setState({ kind: "error", message: describeError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (client === null) {
    return (
      <main className="centered">
        <h1>Content Model Sync</h1>
        <p className="error" role="alert">
          This custom app is not configured. Add <code>{'{"accessSecret": "..."}'}</code> to its
          Parameters {"{JSON}"} in Environment settings &gt; Custom apps.
        </p>
      </main>
    );
  }

  if (state.kind !== "ready") {
    return (
      <main className="centered">
        <h1>Content Model Sync</h1>
        {state.kind === "loading" ? (
          <p>Checking access...</p>
        ) : (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
      </main>
    );
  }

  const { me } = state;

  return (
    <div className="shell">
      <header className="header">
        <strong>Content Model Sync</strong>
        <span>
          {me.user.name ?? me.user.email}
          {me.user.roles.map((role) => (
            <span key={role} className="badge">
              {role}
            </span>
          ))}
        </span>
      </header>
      <main className="content">
        <h2>Master environment</h2>
        <p>
          <code>{me.master.environmentId}</code>
        </p>
        {me.master.key.configured ? (
          <p>Management API key configured ({me.master.key.source} variable).</p>
        ) : (
          <p className="error">
            No Management API key. Add the environment variable{" "}
            <code>{me.master.key.variableName}</code> in Vercel and redeploy.
          </p>
        )}
        <p>Client projects, diff and sync are added in the next Phase 1 slices.</p>
      </main>
    </div>
  );
};

export default App;
