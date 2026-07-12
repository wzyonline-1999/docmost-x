import { GroupController } from './group.controller';

describe('GroupController', () => {
  let controller: GroupController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new GroupController(dependency, dependency, dependency);
  });

  it('should be defined', () => {
    expect(controller).toBeInstanceOf(GroupController);
  });
});
