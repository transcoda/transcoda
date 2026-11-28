import type { ReactNode } from 'react';
import { Redirect, Route, Switch } from 'wouter';
import { HostNotAllowedPage } from './auth/HostNotAllowedPage.tsx';
import { LoginPage } from './auth/LoginPage.tsx';
import { SetupPage } from './auth/SetupPage.tsx';
import { useAuth } from './auth/use-auth.ts';
import { Loading } from './components/Loading.tsx';
import { NotFound } from './components/NotFound.tsx';
import { EditorPage } from './editor/EditorPage/EditorPage.tsx';
import { EventsProvider } from './hooks/use-events.ts';
import { JobPage } from './jobs/JobPage/JobPage.tsx';
import { JobsPage } from './jobs/JobsPage/JobsPage.tsx';
import { RunPage } from './jobs/RunPage/RunPage.tsx';
import { LibrariesPage } from './libraries/LibrariesPage.tsx';
import { LibraryFilePage } from './libraries/LibraryFilePage.tsx';
import { LibraryHealthPage } from './libraries/LibraryHealthPage.tsx';
import { LibraryPage } from './libraries/LibraryPage.tsx';
import { PluginsPage } from './plugins/PluginsPage/PluginsPage.tsx';
import { RecyclePage } from './recycle/RecyclePage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { Shell } from './shell/Shell.tsx';
import { NewWorkflowPage } from './workflows/NewWorkflowPage.tsx';
import { WorkflowsPage } from './workflows/WorkflowsPage.tsx';

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
        {/* The licenses page's old URL (British spelling). */}
        <Route path="/settings/about/licences">
          <Redirect to="/settings/about/licenses" replace />
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
        <Route path="/libraries/:id/files/:fileId">
          {(params) => (
            <RequireAuth>
              <Shell>
                {/* Another file remounts the page, so the last file's data never shows under the new URL. */}
                <LibraryFilePage key={`${params.id}\n${params.fileId}`} />
              </Shell>
            </RequireAuth>
          )}
        </Route>
        <Route path="/libraries/:id/health">
          {(params) => (
            <RequireAuth>
              <Shell>
                <LibraryHealthPage key={params.id} />
              </Shell>
            </RequireAuth>
          )}
        </Route>
        <Route path="/libraries/:id/shows/:show/seasons/:season">
          <RequireAuth>
            <Shell>
              <LibraryPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/libraries/:id/shows/:show">
          <RequireAuth>
            <Shell>
              <LibraryPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/libraries/:id">
          <RequireAuth>
            <Shell>
              <LibraryPage />
            </Shell>
          </RequireAuth>
        </Route>
        <Route path="/recycle">
          <RequireAuth>
            <Shell>
              <RecyclePage />
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
