import { jest } from '@jest/globals';
import { XClient } from '../../src/x-api.js';
import { XError } from '../../src/types.js';
import type { Config } from '../../src/types.js';

// Mock the auth factory
jest.mock('../../src/auth/factory.js', () => ({
  createXClient: jest.fn(() => ({
    v1: {
      uploadMedia: jest.fn(),
    },
    v2: {
      tweet: jest.fn(),
      search: jest.fn(),
    },
  })),
}));

describe('XClient', () => {
  const mockConfig: Config = {
    apiKey: 'test-key',
    apiSecretKey: 'test-secret',
    accessToken: 'test-token',
    accessTokenSecret: 'test-token-secret',
    authType: 'oauth1' as const,
  };

  let xClient: XClient;
  let mockTwitterApi: any;

  beforeEach(() => {
    jest.clearAllMocks();
    xClient = new XClient(mockConfig);
    mockTwitterApi = (xClient as any).client;
    // Disable rate limiting for most tests by mocking checkRateLimit
    (xClient as any).checkRateLimit = jest.fn().mockResolvedValue(undefined);
  });

  describe('postTweet', () => {
    it('should post a simple tweet successfully', async () => {
      const mockResponse = {
        data: { id: '123', text: 'Hello world' }
      };
      mockTwitterApi.v2.tweet.mockResolvedValue(mockResponse);

      const result = await xClient.postTweet('Hello world');

      expect(result).toEqual({
        id: '123',
        text: 'Hello world'
      });
      expect(mockTwitterApi.v2.tweet).toHaveBeenCalledWith({
        text: 'Hello world'
      });
    });

    it('should post a reply tweet successfully', async () => {
      const mockResponse = {
        data: { id: '124', text: 'Hello reply' }
      };
      mockTwitterApi.v2.tweet.mockResolvedValue(mockResponse);

      const result = await xClient.postTweet('Hello reply', '123');

      expect(result).toEqual({
        id: '124',
        text: 'Hello reply'
      });
      expect(mockTwitterApi.v2.tweet).toHaveBeenCalledWith({
        text: 'Hello reply',
        reply: { in_reply_to_tweet_id: '123' }
      });
    });
  });

  describe('uploadMedia', () => {
    it('should upload media successfully', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      mockTwitterApi.v1.uploadMedia.mockResolvedValue('media-123');

      const result = await xClient.uploadMedia(mockBuffer, 'image/jpeg');

      expect(result).toBe('media-123');
      expect(mockTwitterApi.v1.uploadMedia).toHaveBeenCalledWith(mockBuffer, {
        mimeType: 'image/jpeg',
        target: 'tweet'
      });
    });

    it('should throw error for oversized media', async () => {
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB

      await expect(xClient.uploadMedia(largeBuffer, 'image/jpeg'))
        .rejects
        .toThrow(XError);
    });

    it('should provide helpful error for scope issues', async () => {
      const mockBuffer = Buffer.from('fake-image-data');
      const scopeError = new Error('insufficient scope');
      mockTwitterApi.v1.uploadMedia.mockRejectedValue(scopeError);

      await expect(xClient.uploadMedia(mockBuffer, 'image/jpeg'))
        .rejects
        .toThrow('media.write');
    });
  });

  describe('postTweetWithMedia', () => {
    it('should post tweet without media (backward compatibility)', async () => {
      const mockResponse = {
        data: { id: '123', text: 'Hello world' }
      };
      mockTwitterApi.v2.tweet.mockResolvedValue(mockResponse);

      const result = await xClient.postTweetWithMedia('Hello world');

      expect(result).toEqual({
        id: '123',
        text: 'Hello world'
      });
      expect(mockTwitterApi.v2.tweet).toHaveBeenCalledWith({
        text: 'Hello world'
      });
    });

    it('should post tweet with media successfully', async () => {
      const mockResponse = {
        data: { id: '125', text: 'Tweet with image' }
      };
      mockTwitterApi.v1.uploadMedia.mockResolvedValue('media-123');
      mockTwitterApi.v2.tweet.mockResolvedValue(mockResponse);

      const mediaItems = [{
        data: Buffer.from('fake-image').toString('base64'),
        media_type: 'image/jpeg' as const
      }];

      const result = await xClient.postTweetWithMedia(
        'Tweet with image',
        undefined,
        mediaItems
      );

      expect(result).toEqual({
        id: '125',
        text: 'Tweet with image'
      });
      expect(mockTwitterApi.v1.uploadMedia).toHaveBeenCalled();
      expect(mockTwitterApi.v2.tweet).toHaveBeenCalledWith({
        text: 'Tweet with image',
        media: { media_ids: ['media-123'] }
      });
    });

    it('should reject invalid base64 data that decodes to empty buffer', async () => {
      // Padding-only base64 creates empty buffer, triggering validation error
      const invalidMediaItems = [{
        data: '====',
        media_type: 'image/jpeg' as const
      }];

      await expect(xClient.postTweetWithMedia(
        'Tweet with invalid media',
        undefined,
        invalidMediaItems
      )).rejects.toThrow('Invalid base64 media data');
    });

    it('should reject oversized base64 data', async () => {
      const largeBase64 = 'A'.repeat(16 * 1024 * 1024); // 16MB of base64
      const oversizedMediaItems = [{
        data: largeBase64,
        media_type: 'image/jpeg' as const
      }];

      await expect(xClient.postTweetWithMedia(
        'Tweet with large media',
        undefined,
        oversizedMediaItems
      )).rejects.toThrow('Base64 media data too large');
    });

    it('should handle multiple media items', async () => {
      const mockResponse = {
        data: { id: '126', text: 'Multiple images' }
      };
      mockTwitterApi.v1.uploadMedia
        .mockResolvedValueOnce('media-1')
        .mockResolvedValueOnce('media-2');
      mockTwitterApi.v2.tweet.mockResolvedValue(mockResponse);

      const mediaItems = [
        {
          data: Buffer.from('image1').toString('base64'),
          media_type: 'image/jpeg' as const
        },
        {
          data: Buffer.from('image2').toString('base64'),
          media_type: 'image/png' as const
        }
      ];

      const result = await xClient.postTweetWithMedia(
        'Multiple images',
        undefined,
        mediaItems
      );

      expect(result).toEqual({
        id: '126',
        text: 'Multiple images'
      });
      expect(mockTwitterApi.v1.uploadMedia).toHaveBeenCalledTimes(2);
      expect(mockTwitterApi.v2.tweet).toHaveBeenCalledWith({
        text: 'Multiple images',
        media: { media_ids: ['media-1', 'media-2'] }
      });
    });
  });

  describe('rate limiting', () => {
    it('should enforce basic rate limiting', async () => {
      // Create a fresh client without the mocked checkRateLimit
      const rateLimitClient = new XClient(mockConfig);
      const rateLimitMockApi = (rateLimitClient as any).client;

      const mockResponse = {
        data: { id: '123', text: 'First tweet' }
      };
      rateLimitMockApi.v2.tweet.mockResolvedValue(mockResponse);

      // First tweet should succeed
      await rateLimitClient.postTweet('First tweet');

      // Second tweet immediately should fail due to rate limiting
      await expect(rateLimitClient.postTweet('Second tweet'))
        .rejects
        .toThrow('Rate limit');
    });
  });
});