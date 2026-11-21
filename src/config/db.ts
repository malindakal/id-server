import mongoose from 'mongoose';
import dns from 'dns';

// Configure public DNS resolvers to ensure reliable SRV lookup on Windows networks
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
  // If setting custom DNS fails in restricted environments, fall back to default
}

export const connectDB = async (): Promise<void> => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('❌ MONGODB_URI is not defined in environment variables.');
    return;
  }

  try {
    const conn = await mongoose.connect(uri);
    console.log(`🍃 MongoDB Connected successfully: ${conn.connection.host}`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', (error as Error).message);
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
};
