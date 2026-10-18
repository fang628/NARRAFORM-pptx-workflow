import fs from 'node:fs';

// Ignored work/ is absent in a fresh checkout; fixtures must not need manual setup.
fs.mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
