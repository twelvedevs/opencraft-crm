import type { OptOutsRepository } from '../repositories/opt-outs.repo.js';

export class OptOutRegistry {
  constructor(private readonly optOutsRepo: OptOutsRepository) {}

  async isOptedOut(phone: string): Promise<boolean> {
    return this.optOutsRepo.isOptedOut(phone);
  }

  async register(phone: string, source: string): Promise<void> {
    await this.optOutsRepo.create(phone, source);
  }

  async remove(phone: string): Promise<boolean> {
    const existing = await this.optOutsRepo.findByPhone(phone);
    if (!existing) return false;
    await this.optOutsRepo.delete(phone);
    return true;
  }
}
