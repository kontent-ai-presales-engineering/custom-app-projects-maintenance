import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  createApiClient,
  getMe,
  type Me,
  type ProjectView,
  readAccessSecret,
} from "./api/client.ts";
import { AuditLogView } from "./components/AuditLogView.tsx";
import { type DiffTarget, DiffView } from "./components/DiffView.tsx";
import { DriftView } from "./components/DriftView.tsx";
import { OnboardingView } from "./components/OnboardingView.tsx";
import { ProjectOverview } from "./components/ProjectOverview.tsx";
import { ReleasesView } from "./components/ReleasesView.tsx";
import { RolloutView } from "./components/RolloutView.tsx";
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
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [onboarding, setOnboarding] = useState<ProjectView | null>(null);
  const [page, setPage] = useState<"projects" | "drift" | "releases" | "audit">("projects");
  // Set while a rollout is open (from the Drift tab).
  const [rolloutTargets, setRolloutTargets] = useState<ReadonlyArray<DiffTarget> | null>(null);

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
        <nav className="tabs">
          <button
            type="button"
            aria-pressed={page === "projects"}
            onClick={() => setPage("projects")}
          >
            Projects
          </button>
          <button type="button" aria-pressed={page === "drift"} onClick={() => setPage("drift")}>
            Drift
          </button>
          <button
            type="button"
            aria-pressed={page === "releases"}
            onClick={() => setPage("releases")}
          >
            Releases
          </button>
          <button type="button" aria-pressed={page === "audit"} onClick={() => setPage("audit")}>
            Audit log
          </button>
        </nav>
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
        {page === "audit" ? (
          <AuditLogView client={client} />
        ) : page === "releases" ? (
          <ReleasesView client={client} />
        ) : page === "drift" && rolloutTargets !== null ? (
          <RolloutView
            client={client}
            targets={rolloutTargets}
            onBack={() => setRolloutTargets(null)}
          />
        ) : page === "drift" ? (
          <DriftView
            onRollout={setRolloutTargets}
            client={client}
            onCompare={(target) => {
              setDiffTarget(target);
              setPage("projects");
            }}
          />
        ) : diffTarget === null ? (
          onboarding === null ? (
            <ProjectOverview client={client} onCompare={setDiffTarget} onOnboard={setOnboarding} />
          ) : (
            <OnboardingView
              client={client}
              project={onboarding}
              onBack={() => setOnboarding(null)}
              onCompare={(target) => {
                setOnboarding(null);
                setDiffTarget(target);
              }}
            />
          )
        ) : (
          <DiffView client={client} target={diffTarget} onBack={() => setDiffTarget(null)} />
        )}
      </main>
    </div>
  );
};

export default App;
