import SparkMD5 from "spark-md5";

export function md5(text: string): string {
  return SparkMD5.hash(text);
}
