// Type declarations for adbkit-apkreader
declare module 'adbkit-apkreader' {
  import { Readable } from 'stream'

  interface UsesSdk {
    minSdkVersion?: number
    targetSdkVersion?: number
    maxSdkVersion?: number
  }

  interface Permission {
    name: string
    protectionLevel?: number
  }

  interface UsesPermission {
    name: string
    maxSdkVersion?: number
  }

  interface Manifest {
    versionCode: number
    versionName: string
    package: string
    usesSdk?: UsesSdk
    permissions?: Permission[]
    usesPermissions?: UsesPermission[]
    application?: {
      label?: string
      icon?: string
      debuggable?: boolean
    }
  }

  interface ApkReaderInstance {
    readManifest(): Promise<Manifest>
    readXml(path: string): Promise<Document>
  }

  interface ApkReaderStatic {
    open(stream: Readable, length: number): Promise<ApkReaderInstance>
    open(path: string): Promise<ApkReaderInstance>
  }

  const ApkReader: ApkReaderStatic
  export default ApkReader
}
