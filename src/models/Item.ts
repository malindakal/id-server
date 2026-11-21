import mongoose, { Document, Schema } from 'mongoose';

export interface IItem extends Document {
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ItemSchema: Schema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

export const Item = mongoose.model<IItem>('Item', ItemSchema);

