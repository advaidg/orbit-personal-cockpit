import { Collection } from '../server/collection.js';

/** Every stored settings row, exactly as it sits in storage (ciphertext included), for "is it encrypted" checks. */
export async function collectionRowsForTests(): Promise<unknown[]> {
  return new Collection<never>('installation_config').listAllOwners();
}
