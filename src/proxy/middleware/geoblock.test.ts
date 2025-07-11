import { Request, Response, NextFunction } from 'express';
import { geoblockMiddleware } from './geoblock';
import { config } from '../../config';
import geoip from 'geoip-lite';
import { logger } from '../../logger'; // Import logger

// Mock the config and logger
jest.mock('../../config', () => ({
  config: {
    GEOBLOCK_ENABLED: true,
    GEOBLOCK_ALLOWED_COUNTRIES: ['RU', 'BY'],
    GEOBLOCK_DB_PATH: undefined, // Default to geoip-lite's bundled DB
  },
}));

jest.mock('../../logger', () => ({
  logger: {
    child: jest.fn().mockReturnThis(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock geoip-lite
jest.mock('geoip-lite', () => ({
  lookup: jest.fn(),
}));

describe('geoblockMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let nextFunction: NextFunction = jest.fn();
  let statusJsonFn = jest.fn().mockReturnThis(); // to chain .json()

  beforeEach(() => {
    // Reset mocks for each test
    jest.clearAllMocks();
    mockRequest = {
      ip: '1.2.3.4', // Default IP for tests
      ips: [], // Default empty ips array
    };
    mockResponse = {
      status: jest.fn().mockImplementation(() => ({
        json: statusJsonFn,
      })),
    };
    nextFunction = jest.fn();
    // Default mock for geoip.lookup
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'US' }); 
  });

  test('should allow request if geoblocking is disabled', () => {
    config.GEOBLOCK_ENABLED = false;
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
    config.GEOBLOCK_ENABLED = true; // Reset for other tests
  });

  test('should allow request if IP is in an allowed country (RU)', () => {
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'RU' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  test('should allow request if IP is in an allowed country (BY)', () => {
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'BY' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  test('should block request if IP is in a disallowed country (US)', () => {
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'US' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).not.toHaveBeenCalled();
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(statusJsonFn).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(String),
      country_code: 'US',
    }));
  });

  test('should allow request if GeoIP lookup fails (returns null)', () => {
    (geoip.lookup as jest.Mock).mockReturnValue(null);
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  test('should allow request if GeoIP lookup returns no country', () => {
    (geoip.lookup as jest.Mock).mockReturnValue({}); // No country property
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });
  
  test('should allow request for private IP addresses (e.g., 127.0.0.1)', () => {
    mockRequest.ip = '127.0.0.1';
    // For private IPs, geoip.lookup might return null, and it might be in req.ips
    mockRequest.ips = ['127.0.0.1']; 
    (geoip.lookup as jest.Mock).mockImplementation((ip) => ip === '127.0.0.1' ? null : { country: 'US' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  test('should allow request if client IP is not found', () => {
    mockRequest.ip = undefined;
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
  });

  test('should use default allowed country "RU" if config.GEOBLOCK_ALLOWED_COUNTRIES is empty or undefined', () => {
    config.GEOBLOCK_ALLOWED_COUNTRIES = undefined; 
    // Test blocking a non-RU country
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'US' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(mockResponse.status).toHaveBeenCalledWith(403);
    expect(statusJsonFn).toHaveBeenCalledWith(expect.objectContaining({ country_code: 'US' }));
    
    // Test allowing RU
    jest.clearAllMocks(); // Clear mocks before re-calling middleware
    nextFunction = jest.fn(); // Re-assign nextFunction
    mockResponse.status = jest.fn().mockImplementation(() => ({ json: statusJsonFn })); // Re-assign status
    (geoip.lookup as jest.Mock).mockReturnValue({ country: 'RU' });
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(nextFunction).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();

    config.GEOBLOCK_ALLOWED_COUNTRIES = ['RU', 'BY']; // Reset for other tests
  });

  test('should log warning if GEOBLOCK_DB_PATH is set (using geoip-lite)', () => {
    config.GEOBLOCK_DB_PATH = '/some/path/db.mmdb';
    geoblockMiddleware(mockRequest as Request, mockResponse as Response, nextFunction);
    expect(logger.child({ module: 'geoblock' }).warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: config.GEOBLOCK_DB_PATH }),
        expect.stringContaining("GEOBLOCK_DB_PATH is set, but this version uses the bundled geoip-lite database.")
    );
    config.GEOBLOCK_DB_PATH = undefined; // Reset for other tests
  });
});
