import { Request, Response, NextFunction } from 'express';
import geoip from 'geoip-lite';
import { config } from '../../config';
import { logger } from '../../logger';

const log = logger.child({ module: 'geoblock' });

export function geoblockMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!config.GEOBLOCK_ENABLED) {
    return next();
  }

  const clientIp = req.ip;
  if (!clientIp) {
    log.warn('Client IP address not found, skipping geoblock.');
    return next(); 
  }

  // Allow private IP addresses - useful for local development and testing
  // req.ip might return private IPs like 127.0.0.1, 192.168.x.x, 10.x.x.x
  // geoip-lite returns null for these.
  const ipIsPrivate = req.ips.includes(clientIp) && geoip.lookup(clientIp) === null;

  if (ipIsPrivate) {
    log.debug({ ip: clientIp }, 'Client IP is private, skipping geoblock.');
    return next();
  }
  
  let geo;
  try {
    if (config.GEOBLOCK_DB_PATH) {
        // This is a placeholder. If a user provides GEOBLOCK_DB_PATH,
        // they'd expect the 'maxmind' library to be used.
        // For now, we'll log a warning if this path is set but stick to geoip-lite.
        // A future enhancement would be to dynamically switch to 'maxmind'
        // or advise the user to install a version of the proxy with 'maxmind'.
        log.warn({ path: config.GEOBLOCK_DB_PATH }, "GEOBLOCK_DB_PATH is set, but this version uses the bundled geoip-lite database. For an external database, a version with the 'maxmind' library is required.");
        geo = geoip.lookup(clientIp);
    } else {
        geo = geoip.lookup(clientIp);
    }
  } catch (error) {
    log.error({ ip: clientIp, error }, 'Error during GeoIP lookup.');
    // Fail open (allow request) in case of error to avoid blocking legitimate users
    return next();
  }

  if (!geo || !geo.country) {
    log.warn({ ip: clientIp }, 'GeoIP lookup failed or country not found, allowing request.');
    // Allow request if lookup fails or country is not found
    return next();
  }

  const allowedCountries = config.GEOBLOCK_ALLOWED_COUNTRIES || ['RU'];
  if (allowedCountries.includes(geo.country)) {
    log.debug({ ip: clientIp, country: geo.country }, 'Access granted by geoblock.');
    return next();
  } else {
    log.warn({ ip: clientIp, country: geo.country, allowed: allowedCountries }, 'Access denied by geoblock.');
    return res.status(403).json({
      error: 'Access denied. Ask access here annonium@proton.me',
      country_code: geo.country,
    });
  }
}
