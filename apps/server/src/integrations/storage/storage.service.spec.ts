import { StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    service = new StorageService({} as never);
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(StorageService);
  });
});
