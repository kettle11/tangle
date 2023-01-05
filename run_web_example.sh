# exit when any command fails
set -e

./build_web_example.sh
devserver --path web_example
