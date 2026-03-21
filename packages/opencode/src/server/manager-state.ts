export namespace ManagerState {
  export interface Service {
    id: string
    name: string
    description: string
    url: string
    icon: string
  }

  let _services: Service[] = []
  let _enabled = false

  export function enable() {
    _enabled = true
  }

  export function isEnabled() {
    return _enabled
  }

  export function register(services: Service[]) {
    _services = services
  }

  export function list(): Service[] {
    return _services
  }
}
