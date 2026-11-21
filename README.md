# ID Server

Node.js + Express backend server built with **TypeScript**, **Mongoose (MongoDB Atlas)**, **Cloudflare R2 Object Storage (profile-pictures & documents folders)**, **JWT Authentication**, and **Nodemon**.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- npm (v9+)
- MongoDB Atlas cluster
- Cloudflare R2 bucket

## Cloudflare R2 Storage Folders

The storage service organizes all uploads into two standardized folders:
1. `profile-pictures/`: Stores user avatar images and profile photos.
2. `documents/`: Stores user attachments, reports, and media documents.

Public CDN access paths:
- Profile pictures: `https://pub-0d49bd72f6914abbbae9957be8a60ecc.r2.dev/profile-pictures/<filename>`
- Documents: `https://pub-0d49bd72f6914abbbae9957be8a60ecc.r2.dev/documents/<filename>`

## API Endpoints

### Cloudflare R2 Storage
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/storage/folders` | List available storage folders (`profile-pictures`, `documents`) |
| `POST` | `/api/storage/init-folders` | Initialize/ensure both folders exist in R2 |
| `POST` | `/api/storage/upload-avatar` | Upload profile photo directly to `profile-pictures/` folder |
| `POST` | `/api/storage/upload-document` | Upload document directly to `documents/` folder |
| `POST` | `/api/storage/upload` | Upload to specified folder (`folder: 'profile-pictures' \| 'documents'`) |
| `GET` | `/api/storage/files?folder=...` | List files filtered by folder |
| `DELETE` | `/api/storage/files` | Delete file from R2 bucket (`{ "key": "..." }`) |

### Authentication
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register user; returns `{ accessToken, refreshToken, user }` |
| `POST` | `/api/auth/login` | Sign in user; returns `{ accessToken, refreshToken, user }` |
| `POST` | `/api/auth/google` | Google sign-in; returns `{ accessToken, refreshToken, user }` |
| `POST` | `/api/auth/refresh` | Renew `accessToken` using `refreshToken` |
| `POST` | `/api/auth/logout` | Revoke stored `refreshToken` |
| `GET` | `/api/auth/me` | Protected route (Requires `Authorization: Bearer <accessToken>`) |

### Items & System
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Root server status, DB connection, & Cloudflare R2 info |
| `GET` | `/api/health` | Health check with uptime and DB status |
| `GET` | `/api/items` | List all items stored in MongoDB Atlas |
| `GET` | `/api/items/:id` | Get item by MongoDB ObjectId |
| `POST` | `/api/items` | Create new item |
| `DELETE` | `/api/items/:id` | Delete item by MongoDB ObjectId |
