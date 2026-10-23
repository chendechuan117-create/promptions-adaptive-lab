import { createRoot } from 'react-dom/client';
import { App } from './prethink';
import { createMcpTransport } from './prethink-mcp';

const mount = document.getElementById('root');
if (!mount) throw new Error('Missing root element');
createRoot(mount).render(<App transport={createMcpTransport()} embedded />);
