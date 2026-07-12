import { GroupService } from './group.service';

describe('GroupService', () => {
  let service: GroupService;
  const dependency = {} as never;

  beforeEach(() => {
    service = new GroupService(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(service).toBeInstanceOf(GroupService);
  });
});
