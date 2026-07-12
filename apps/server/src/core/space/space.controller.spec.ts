import { SpaceController } from './space.controller';

describe('SpaceController', () => {
  let controller: SpaceController;
  const dependency = {} as never;

  beforeEach(() => {
    controller = new SpaceController(
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeInstanceOf(SpaceController);
  });
});
