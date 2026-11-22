import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import jwt, { JwtPayload } from 'jsonwebtoken';
import multer from 'multer';
import { connectDB } from './config/db';
import { Item } from './models/Item';
import { User, IUser } from './models/User';
import {
  uploadToR2,
  uploadProfilePicture,
  uploadDocument,
  deleteFromR2,
  listR2Files,
  createR2Folders,
  getObjectFromR2,
  R2_CONFIG,
  R2_FOLDERS,
  checkR2Connection,
  ALLOWED_PROFILE_PICTURE_MIMES,
  isAllowedProfilePictureMime,
} from './config/r2';

dotenv.config();

const app: Application = express();
const PORT: number = parseInt(process.env.PORT || '5000', 10);
const JWT_SECRET: string = process.env.JWT_SECRET || 'default_jwt_access_secret';
const JWT_REFRESH_SECRET: string = process.env.JWT_REFRESH_SECRET || 'default_jwt_refresh_secret';

// Connect to MongoDB
connectDB();

// Initialize R2 storage folders
createR2Folders().catch(() => {});

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Multer in-memory storage for handling file uploads before sending to Cloudflare R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
});

// Token generation helpers
export const generateTokens = (userId: string) => {
  const accessToken = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: userId }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
};

// Express Request extension for authenticated user
export interface AuthenticatedRequest extends Request {
  user?: IUser;
}

// Authentication middleware using Access Token
export const authenticateToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    res.status(401).json({ error: 'Access token is required.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      res.status(401).json({ error: 'User associated with token not found.' });
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(403).json({ error: 'Invalid or expired access token. Please refresh your token.' });
  }
};

// Root endpoint
app.get('/', async (_req: Request, res: Response) => {
  const dbStates: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  const isR2Connected = await checkR2Connection();

  res.json({
    status: 'success',
    message: 'Node.js + Express + TypeScript server is running with MongoDB & Cloudflare R2 Folders!',
    database: dbStates[mongoose.connection.readyState] || 'unknown',
    storage: {
      provider: 'Cloudflare R2 Storage (S3 API)',
      connected: isR2Connected,
      publicUrl: R2_CONFIG.publicUrl,
      folders: [R2_FOLDERS.PROFILE_PICTURES, R2_FOLDERS.DOCUMENTS],
    },
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get('/api/health', async (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    databaseConnected: mongoose.connection.readyState === 1,
    storage: {
      provider: 'Cloudflare R2',
      publicUrl: R2_CONFIG.publicUrl,
      folders: [R2_FOLDERS.PROFILE_PICTURES, R2_FOLDERS.DOCUMENTS],
    },
    timestamp: new Date().toISOString(),
  });
});

/* ==================== CLOUDFLARE R2 STORAGE ROUTES ==================== */

// Get available R2 folders
app.get('/api/storage/folders', (_req: Request, res: Response) => {
  res.json({
    folders: [
      { name: R2_FOLDERS.PROFILE_PICTURES, description: 'Profile pictures and user avatars' },
      { name: R2_FOLDERS.DOCUMENTS, description: 'User documents, attachments, and media files' },
    ],
  });
});

// Initialize / Ensure R2 folders exist
app.post('/api/storage/init-folders', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await createR2Folders();
    res.json({
      message: 'Cloudflare R2 storage folders verified',
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

// Stream/serve file directly from Cloudflare R2
app.get(['/api/storage/file/:folder/:fileName', '/api/storage/file/*'], async (req: Request, res: Response): Promise<void> => {
  try {
    const rawParam = (req.params as any)[0];
    const key = rawParam || (req.params.folder && req.params.fileName ? `${req.params.folder}/${req.params.fileName}` : '');
    if (!key) {
      res.status(400).json({ error: 'File key is required' });
      return;
    }
    const object = await getObjectFromR2(key);

    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength);
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (object.Body) {
      const stream = object.Body as import('stream').Readable;
      stream.pipe(res);
    } else {
      res.status(404).json({ error: 'File body empty' });
    }
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: 'File not found in storage' });
    } else {
      console.error('Error serving file from R2:', err.message || err);
      res.status(500).json({ error: 'Failed to retrieve file from storage' });
    }
  }
});

// Upload profile photo into 'profile-pictures' folder
app.post(
  '/api/storage/upload-avatar',
  upload.single('avatar'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No avatar image uploaded.' });
        return;
      }

      if (!isAllowedProfilePictureMime(req.file.mimetype)) {
        res.status(400).json({
          error: 'Only PNG and JPEG file types are allowed for profile pictures (image/png, image/jpeg).',
        });
        return;
      }

      const result = await uploadProfilePicture(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      const host = req.get('host') || `localhost:${PORT}`;
      const protocol = req.protocol || 'http';
      const streamUrl = `${protocol}://${host}/api/storage/file/${result.key}`;

      // If user ID provided, sync avatar URL in MongoDB
      const userId = req.body.userId;
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        await User.findByIdAndUpdate(userId, { avatar: streamUrl });
      }

      res.status(201).json({
        message: 'Profile picture uploaded to Cloudflare R2 (profile-pictures folder)',
        avatarUrl: streamUrl,
        publicR2Url: result.url,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Upload document into 'documents' folder
app.post(
  '/api/storage/upload-document',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded.' });
        return;
      }

      const result = await uploadDocument(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      res.status(201).json({
        message: 'Document uploaded to Cloudflare R2 (documents folder)',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// General upload (supporting specific folder selection)
app.post(
  '/api/storage/upload',
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded.' });
        return;
      }

      const folder = (req.body.folder as string) === R2_FOLDERS.PROFILE_PICTURES
        ? R2_FOLDERS.PROFILE_PICTURES
        : R2_FOLDERS.DOCUMENTS;

      if (folder === R2_FOLDERS.PROFILE_PICTURES && !isAllowedProfilePictureMime(req.file.mimetype)) {
        res.status(400).json({
          error: 'Only PNG and JPEG file types are allowed for profile pictures (image/png, image/jpeg).',
        });
        return;
      }

      const result = await uploadToR2(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        folder
      );

      res.status(201).json({
        message: `File uploaded to Cloudflare R2 (${folder} folder)`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

// List files in Cloudflare R2 bucket (optionally filtered by folder)
app.get('/api/storage/files', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const folder = req.query.folder as string;
    const prefix = folder ? `${folder}/` : '';
    const files = await listR2Files(prefix);
    res.json({
      folder: folder || 'all',
      count: files.length,
      data: files,
    });
  } catch (error) {
    next(error);
  }
});

// Delete file from Cloudflare R2
app.delete('/api/storage/files', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key } = req.body;
    if (!key) {
      res.status(400).json({ error: 'Object key is required to delete.' });
      return;
    }

    const success = await deleteFromR2(key);
    res.json({ message: 'File deleted from Cloudflare R2', success });
  } catch (error) {
    next(error);
  }
});

/* ==================== AUTHENTICATION ROUTES ==================== */

// Register new user (local)
app.post(
  '/api/auth/register',
  async (
    req: Request<{}, {}, { name?: string; email?: string; password?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { name, email, password } = req.body;

      if (!name || !email || !password) {
        res.status(400).json({ error: 'Name, email, and password are required.' });
        return;
      }

      if (password.length < 6) {
        res.status(400).json({ error: 'Password must be at least 6 characters.' });
        return;
      }

      const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
      if (existingUser) {
        res.status(409).json({ error: 'An account with this email already exists.' });
        return;
      }

      const user = await User.create({
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password,
        provider: 'local',
      });

      const { accessToken, refreshToken } = generateTokens(user._id.toString());
      user.refreshToken = refreshToken;
      await user.save();

      res.status(201).json({
        message: 'Account registered successfully',
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          provider: user.provider,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Sign in existing user (local)
app.post(
  '/api/auth/login',
  async (
    req: Request<{}, {}, { email?: string; password?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }

      const user = await User.findOne({ email: email.toLowerCase().trim() });
      if (!user) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      if (user.provider === 'google' && !user.password) {
        res.status(400).json({
          error: 'This account was created with Google Sign-In. Please click "Continue with Google".',
        });
        return;
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      const { accessToken, refreshToken } = generateTokens(user._id.toString());
      user.refreshToken = refreshToken;
      await user.save();

      res.json({
        message: 'Signed in successfully',
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          provider: user.provider,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Google Sign-In endpoint
app.post(
  '/api/auth/google',
  async (
    req: Request<{}, {}, { email?: string; name?: string; googleId?: string; avatar?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { email, name, googleId, avatar } = req.body;

      if (!email) {
        res.status(400).json({ error: 'Google account email is required.' });
        return;
      }

      let user = await User.findOne({ email: email.toLowerCase().trim() });

      if (!user) {
        user = await User.create({
          name: name?.trim() || email.split('@')[0],
          email: email.toLowerCase().trim(),
          provider: 'google',
          googleId: googleId || undefined,
          avatar: avatar || undefined,
        });
      } else {
        if (user.provider !== 'google' && !user.googleId && googleId) {
          user.googleId = googleId;
          if (avatar && !user.avatar) user.avatar = avatar;
        }
      }

      const { accessToken, refreshToken } = generateTokens(user._id.toString());
      user.refreshToken = refreshToken;
      await user.save();

      res.json({
        message: 'Google authentication successful',
        accessToken,
        refreshToken,
        expiresIn: 900,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          provider: user.provider,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// Refresh Token endpoint
app.post(
  '/api/auth/refresh',
  async (
    req: Request<{}, {}, { refreshToken?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token is required.' });
        return;
      }

      let decoded: JwtPayload;
      try {
        decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as JwtPayload;
      } catch (err) {
        res.status(403).json({ error: 'Invalid or expired refresh token. Please sign in again.' });
        return;
      }

      const user = await User.findById(decoded.id);
      if (!user || user.refreshToken !== refreshToken) {
        res.status(403).json({ error: 'Refresh token has been revoked or is invalid.' });
        return;
      }

      const tokens = generateTokens(user._id.toString());
      user.refreshToken = tokens.refreshToken;
      await user.save();

      res.json({
        message: 'Token refreshed successfully',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: 900,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Logout: revokes the stored refresh token
app.post(
  '/api/auth/logout',
  async (
    req: Request<{}, {}, { refreshToken?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        await User.findOneAndUpdate({ refreshToken }, { $unset: { refreshToken: 1 } });
      }

      res.json({ message: 'Logged out successfully and token revoked.' });
    } catch (error) {
      next(error);
    }
  }
);

// Get current user profile (Protected route using Access Token)
app.get('/api/auth/me', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'success',
    user: req.user,
  });
});

/* ==================== ITEMS CRUD ROUTES ==================== */

app.get('/api/items', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const items = await Item.find().sort({ createdAt: -1 });
    res.json({ count: items.length, data: items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/items/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: 'Invalid MongoDB ObjectId' });
      return;
    }

    const item = await Item.findById(id);
    if (!item) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    res.json(item);
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/items',
  async (
    req: Request<{}, {}, { name?: string; description?: string }>,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const { name, description } = req.body;

      if (!name || typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ error: 'Name is required' });
        return;
      }

      const newItem = await Item.create({
        name: name.trim(),
        description: description?.trim() || '',
      });

      res.status(201).json(newItem);
    } catch (error) {
      next(error);
    }
  }
);

app.delete('/api/items/:id', async (req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: 'Invalid MongoDB ObjectId' });
      return;
    }

    const deletedItem = await Item.findByIdAndDelete(id);
    if (!deletedItem) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    res.json({ message: 'Item deleted successfully', item: deletedItem });
  } catch (error) {
    next(error);
  }
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`⚡[server]: Server is running at http://localhost:${PORT}`);
  console.log(`📁[storage]: Cloudflare R2 Folders initialized: /${R2_FOLDERS.PROFILE_PICTURES} & /${R2_FOLDERS.DOCUMENTS}`);
});

export default app;
