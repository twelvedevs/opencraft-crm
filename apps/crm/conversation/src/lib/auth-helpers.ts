/**
 * Returns true if the user has access to the given locationId.
 * An empty locations array means all-locations access (manager/admin roles).
 */
export function hasLocationAccess(userLocations: string[], locationId: string): boolean {
  if (userLocations.length === 0) return true;
  return userLocations.includes(locationId);
}
