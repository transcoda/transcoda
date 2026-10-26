import type { ReactNode } from 'react';
import { Redirect, Route, Switch } from 'wouter';
import { useAuth } from './auth/useAuth.ts';
import { Loading } from './components/Loading.tsx';
import { NotFound } from './components/NotFound.tsx';
import { Shell } from './components/Shell.tsx';
import { EventsProvider } from './hooks/useEvents.ts';
import { EditorPage } from './pages/EditorPage.tsx';
import { HostNotAllowedPage } from './pages/HostNotAllowedPage.tsx';
import { JobPage } from './pages/JobPage.tsx';
import { JobsPage } from './pages/JobsPage.tsx';
import { LibrariesPage } from './pages/LibrariesPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { NewWorkflowPage } from './pages/NewWorkflowPage.tsx';
import { PluginsPage } from './pages/PluginsPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';
import { WorkflowsPage } from './pages/WorkflowsPage.tsx';

/** The session check, before any screen can render: the shared Loading, filling the screen. */
function AppLoading() {
  return (
    <main className="app-loading">
      <Loading />
    </main>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <AppLoading />;
  if (status === 'setup') return <Redirect to="/setup" />;
  if (status === 'anonymous') return <Redirect to="/login" />;
  return <>{children}</>;
}

function Gate({ page, when }: { page: ReactNode; when: 'setup' | 'anonymous' }) {
  const { status } = useAuth();
  if (status === 'loading') return <AppLoading />;
  if (status === 'authenticated') return <Redirect to="/" />;
  if (when === 'anonymous' && status === 'setup') return <Redirect to="/setup" />;
  if (when === 'setup' && status === 'anonymous') return <Redirect to="/login" />;
  return <>{page}</>;
}

export function App() {
  const { status, blockedHost } = useAuth();
  if (status === 'host-not-allowed') return <HostNotAllowedPage host={blockedHost ?? ''} />;
  // One event stream per tab for every signed-in page; it lives above the routes so navigating
  // does not reconnect, and starts only once the session is known.
  return (
    <EventsProvider enabled={status === 'authenticated'}>
      <Switch>
        <Route path="/setup">
          <Gate when="setup" page={<SetupPage />} />
        </Route>
        <Route path="/login">
          <Gate when="anonymous" page={<LoginPage />} />
        </Route>
        {/* The tokens screen's old URL (before Settings). */}
        <Route path="/settings/tokens">
          <Redirect to="/settings/api-tokens" replace />
        </Route>
        <Route path="/settings/:section?/:sub?">
          {(params) => (
            <RequireAuth>
              <Shell>
                <SettingsPage section={params.section} sub={params.sub} />
              </Shell>
            </RequireAuth>
          )}
        </Route>
        <Route path="/jobs">
          <RequireAuth>
            <Shell>
              <JobsPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/libraries">
          <RequireAuth>
            <Shell>
              <LibrariesPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/plugins">
          <RequireAuth>
            <Shell>
              <PluginsPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/workflows/new">
          <RequireAuth>
            <Shell>
              <NewWorkflowPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/workflows/:id">
          <RequireAuth>
            <Shell rail>
              <EditorPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/jobs/:id">
          <RequireAuth>
            <Shell>
              <JobPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/runs/:id">
          <RequireAuth>
            <Shell>
              <RunPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/">
          <RequireAuth>
            <Shell>
              <WorkflowsPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route>
          <RequireAuth>
            <Shell>
              <NotFound />
            </Shell>
          </RequireAuth>
        </Route>
      </Switch>
    </EventsProvider>
  );
}
