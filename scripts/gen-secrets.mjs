#!/usr/bin/env node
// Prints the two long random secrets Orbit needs, ready to paste into Railway, Hostinger, Docker or a .env file.
import crypto from 'node:crypto';

const make = () => crypto.randomBytes(32).toString('hex');
console.log(`SESSION_SECRET=${make()}`);
console.log(`APP_ENCRYPTION_KEY=${make()}`);
console.error('\nKeep these private. Use different values on every installation, and never change APP_ENCRYPTION_KEY after connecting accounts.');
