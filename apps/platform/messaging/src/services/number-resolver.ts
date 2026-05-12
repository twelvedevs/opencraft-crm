import type { NumbersRepository } from '../repositories/numbers.repo.js';

export class NumberNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumberNotFoundError';
  }
}

export class NumberResolver {
  constructor(private readonly numbersRepo: NumbersRepository) {}

  async resolve(params: {
    from_number?: string;
    location_id?: string;
    channel?: string;
  }): Promise<{ phone_number: string; rate_limit_mps: number }> {
    if (params.from_number) {
      const number = await this.numbersRepo.findByPhoneNumber(params.from_number);
      return {
        phone_number: params.from_number,
        rate_limit_mps: number?.rate_limit_mps ?? 3,
      };
    }

    if (params.location_id && params.channel) {
      const number = await this.numbersRepo.findByLocationAndChannel(
        params.location_id,
        params.channel,
      );
      if (!number) {
        throw new NumberNotFoundError(
          `No active number for location=${params.location_id} channel=${params.channel}`,
        );
      }
      return {
        phone_number: number.phone_number,
        rate_limit_mps: number.rate_limit_mps,
      };
    }

    throw new NumberNotFoundError('Either from_number or location_id+channel must be provided');
  }
}
