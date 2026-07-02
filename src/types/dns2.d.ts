declare module "dns2" {
  interface DnsAnswer {
    name: string;
    type: number;
    class: number;
    ttl: number;
    address?: string;
    data?: string;
    exchange?: string;
    priority?: number;
    ns?: string;
    primary?: string;
    admin?: string;
    serial?: number;
    refresh?: number;
    retry?: number;
    expiration?: number;
    minimum?: number;
  }

  interface DnsResponse {
    answers: DnsAnswer[];
  }

  interface DnsOptions {
    nameServers?: string[];
    timeout?: number;
  }

  class DNS {
    constructor(options?: DnsOptions);
    resolve(domain: string, type: string | number): Promise<DnsResponse>;
  }

  export default DNS;
}
