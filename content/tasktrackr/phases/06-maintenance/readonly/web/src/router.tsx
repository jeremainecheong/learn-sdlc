/**
 * The three screens, behind a hash router.
 *
 * createHashRouter, not createBrowserRouter, and that is a deployment decision
 * rather than a style one. A hash never reaches the server, so web/serve.js
 * needs no "send every unknown path to index.html" fallback, and the live
 * preview — which runs the page in a sandboxed frame with an opaque origin,
 * where pushing entries onto the browser's history is unreliable — works
 * without a special case.
 */

import { Link, Outlet, createHashRouter } from 'react-router-dom';

import { ListsPage } from './pages/ListsPage';
import { OverduePage } from './pages/OverduePage';
import { TasksPage } from './pages/TasksPage';

function Shell() {
  return (
    <div className="shell">
      <header>
        <Link to="/" className="brand" data-testid="nav-lists">
          TaskTrackr
        </Link>
        <nav>
          <Link to="/overdue" data-testid="nav-overdue">
            Overdue
          </Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <section data-testid="not-found">
      <h1>No such page</h1>
      <p>
        <Link to="/">Back to your lists</Link>
      </p>
    </section>
  );
}

// These routes keep the same hash URLs in the local server and live preview.
export const routes = [
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <ListsPage /> },
      { path: 'lists/:listId', element: <TasksPage /> },
      { path: 'overdue', element: <OverduePage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];

export const router = createHashRouter(routes);
