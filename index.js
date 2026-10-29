import { startWebFunction } from './src/aws-web.mjs';

// Lambda nodejs24.x loads this default entrypoint and provides host:port.
// Secrets are retrieved lazily; startup never waits for a network operation.
startWebFunction();
