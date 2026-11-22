/**
 * Where the front end starts: one root, one router, nothing else.
 */

import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { router } from './router';

const mount = document.getElementById('root');
if (!mount) throw new Error('index.html has no #root to mount into');

createRoot(mount).render(<RouterProvider router={router} />);
